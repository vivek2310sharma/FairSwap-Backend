// Deterministic matching keys. MUST stay byte-equivalent to the SQL functions
// app_security.wearable_name_key / wearable_base_key in the Backend migration;
// tests prove JS == SQL for every catalogue row.
export const FINISH_WORDS = ["gold", "silver", "matte", "grey", "gray", "black", "white", "titanium", "ceramic", "rose", "space", "raw", "bionic"];

export function nameKey(value) {
  return String(value).toLowerCase().replace(/\+/g, " plus ").replace(/[^a-z0-9]+/g, " ").replace(/^ +| +$/g, "");
}

export function baseKey(value) {
  return nameKey(value).split(" ").filter((w) => w !== "" && !FINISH_WORDS.includes(w)).join(" ");
}
