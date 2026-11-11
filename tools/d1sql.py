"""
SQL for D1 loads that write only what changed (docs/data-sync.md, "What Cloudflare costs").

D1 bills every row written and every index entry it touches, so a load that reads a source
again must write nothing for rows that didn't change. Two pieces, both plain SQL (the tools
send .sql files through wrangler, so nothing is read first):

  upserts(table, cols, rows, key)   multi-row INSERT ... ON CONFLICT (key) DO UPDATE SET ...
                                    WHERE <a value differs>: new rows are inserted, changed rows
                                    updated, identical rows not written at all.
  prune(table, scope, key, keep)    DELETE the scope's rows whose key isn't in `keep`: rows
                                    no longer in the source, and only those.

Together they replace "DELETE the scope, INSERT it again", which rewrote every row each time.
Standard library only; tested in tools/test_d1sql.py.
"""

ROWS_PER_INSERT = 200
MAX_STATEMENT = 90_000  # D1 refuses a statement over 100 KB


def lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def differs(table, cols):
    """The WHERE that makes an upsert write only when a value changed."""
    return " OR ".join(f"{table}.{c} IS NOT excluded.{c}" for c in cols)


def upserts(table, cols, rows, key, stamp=None, keep_old=(), rows_per=ROWS_PER_INSERT, max_size=MAX_STATEMENT):
    """Multi-row upserts of `rows` (sequences in `cols` order) that skip identical rows.

    key:      the conflict target (the table's primary key or a unique index).
    stamp:    a column set to datetime('now') on each row written (insert or change).
    keep_old: columns whose saved value is kept when the new one is NULL (COALESCE).
    """
    cols = list(cols)
    upd = [c for c in cols if c not in key]
    all_cols = cols + ([stamp] if stamp else [])
    if upd:
        sets = [f"{c} = COALESCE(excluded.{c}, {table}.{c})" if c in keep_old else f"{c} = excluded.{c}" for c in upd]
        if stamp:
            sets.append(f"{stamp} = excluded.{stamp}")
        changed = [f"{table}.{c} IS NOT excluded.{c}" if c not in keep_old else f"(excluded.{c} IS NOT NULL AND {table}.{c} IS NOT excluded.{c})" for c in upd]
        tail = f" ON CONFLICT ({', '.join(key)}) DO UPDATE SET {', '.join(sets)} WHERE {' OR '.join(changed)};"
    else:
        tail = f" ON CONFLICT ({', '.join(key)}) DO NOTHING;"
    head = f"INSERT INTO {table} ({', '.join(all_cols)}) VALUES "
    out, part, size = [], [], len(head) + len(tail)
    for row in rows:
        v = "(" + ", ".join([lit(x) for x in row] + (["datetime('now')"] if stamp else [])) + ")"
        if part and (len(part) >= rows_per or size + len(v) + 2 > max_size):
            out.append(head + ", ".join(part) + tail)
            part, size = [], len(head) + len(tail)
        part.append(v)
        size += len(v) + 2
    if part:
        out.append(head + ", ".join(part) + tail)
    return out


def prune(table, scope, key, keep, existing=None, max_size=MAX_STATEMENT):
    """DELETE the rows of `scope` ({column: value}) whose `key` (column names) isn't among `keep`
    (key values, or tuples of them). An empty `keep` deletes the scope's rows.

    existing: the scope's keys already in D1, when the caller read them (a read costs a
    thousandth of a write): then only the rows gone from the source are named, in chunks, which
    works for a scope of any size. Without it, one NOT IN statement, for scopes that fit in one.
    """
    where = " AND ".join(f"{c} IS {lit(v)}" for c, v in scope.items()) or "1"
    norm = lambda k: tuple(k) if isinstance(k, (list, tuple)) else (k,)
    keep = list(dict.fromkeys(norm(k) for k in keep))
    target = key[0] if len(key) == 1 else "(" + ", ".join(key) + ")"
    val = lambda k: lit(k[0]) if len(key) == 1 else "(" + ", ".join(lit(x) for x in k) + ")"
    if existing is not None:
        kept = {tuple(str(x) for x in k) for k in keep}
        gone = [norm(k) for k in existing if tuple(str(x) for x in norm(k)) not in kept]
        out, part, size = [], [], 0
        for k in gone:
            v = val(k)
            if part and size + len(v) > max_size - 500:
                out.append(f"DELETE FROM {table} WHERE {where} AND {target} IN ({'VALUES ' if len(key) > 1 else ''}{', '.join(part)});")
                part, size = [], 0
            part.append(v)
            size += len(v) + 2
        if part:
            out.append(f"DELETE FROM {table} WHERE {where} AND {target} IN ({'VALUES ' if len(key) > 1 else ''}{', '.join(part)});")
        return out
    if not keep:
        return [f"DELETE FROM {table} WHERE {where};"]
    stmt = f"DELETE FROM {table} WHERE {where} AND {target} NOT IN ({'VALUES ' if len(key) > 1 else ''}{', '.join(val(k) for k in keep)});"
    if len(stmt.encode()) >= max_size:
        raise ValueError(f"prune({table}): {len(keep)} keys don't fit in one statement; pass existing= (the keys in D1)")
    return [stmt]
