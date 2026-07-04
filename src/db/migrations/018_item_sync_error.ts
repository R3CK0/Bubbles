// Remember the last sync error per bank so the UI can flag an item that needs
// re-authentication (e.g. Plaid ITEM_LOGIN_REQUIRED) and offer a reconnect
// (Link update mode). Cleared automatically on the next successful sync.
export const migration = {
  version: 18,
  name: "item_sync_error",
  sql: `
ALTER TABLE items ADD COLUMN last_sync_error TEXT;
`,
};
