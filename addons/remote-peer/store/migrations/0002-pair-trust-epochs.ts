export const PAIR_TRUST_EPOCHS_SQL = `
ALTER TABLE pair_inbound ADD COLUMN trust_epoch INTEGER NOT NULL DEFAULT 1 CHECK (trust_epoch >= 1);
ALTER TABLE pair_outbound ADD COLUMN trust_epoch INTEGER NOT NULL DEFAULT 1 CHECK (trust_epoch >= 1);
`;
