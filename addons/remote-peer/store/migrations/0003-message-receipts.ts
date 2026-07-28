export const MESSAGE_RECEIPTS_SQL = `
ALTER TABLE inbound_messages ADD COLUMN receipt_json TEXT;
`;
