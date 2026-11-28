// The site's own reading of an agenda's comment instructions, for tools/test_clairic.py:
// stdin is a JSON array of page texts; stdout is commentInfo(pages).comment_text as JSON
// (workers/sync/src/meetings/comment.js, the code that fills meetings.comment_text).
import { commentInfo } from "../workers/sync/src/meetings/comment.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify(commentInfo(JSON.parse(input)).comment_text));
