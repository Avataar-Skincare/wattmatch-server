'use strict';

// organizationName now stores an encrypted blob (see fieldEncryption.ts /
// LIVE_AUCTION_IDENTITY_ENCRYPTION_PLAN.md), not the plaintext name — a KMS ciphertext blob
// reliably exceeds the default VARCHAR(255) even for a short name, once base64-encoded alongside
// KMS's own envelope metadata. Widened up front rather than discovered later as a truncation error.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('wattmatch_auction_participants', 'organization_name', {
      type: Sequelize.TEXT,
      allowNull: false,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('wattmatch_auction_participants', 'organization_name', {
      type: Sequelize.STRING,
      allowNull: false,
    });
  },
};
