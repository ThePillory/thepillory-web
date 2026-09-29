// Open States v3 API base and headers. https://docs.openstates.org/api-v3/
export const API = "https://v3.openstates.org";

export function headers(env) {
  if (!env.OPENSTATES_API_KEY) throw new Error("OPENSTATES_API_KEY secret is not set");
  return { "X-API-KEY": env.OPENSTATES_API_KEY, Accept: "application/json" };
}
