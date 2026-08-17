'use strict';

// Backs the hash-chain's fork-prevention with a real database constraint instead of an
// application-level lock (see auctionEngine.ts's appendAuditedBid — the write lock this replaces
// had a genuine correctness bug around session/connection-pinning). A unique index on
// (auction_id, prev_hash) means two concurrent writers racing to extend the same auction's chain
// from the same prevHash can no longer both succeed — the database itself rejects the second one,
// which then retries against the now-updated chain. NULL is normalized to '' first: most SQL
// engines, including MySQL, treat every NULL as distinct from every other NULL in a unique index,
// so a bare-nullable column would silently fail to catch exactly the race this exists to prevent —
// two concurrent *first* bids for a brand-new auction, both with prevHash = NULL.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query("UPDATE wattmatch_auction_bids SET prev_hash = '' WHERE prev_hash IS NULL");
    await queryInterface.changeColumn('wattmatch_auction_bids', 'prev_hash', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: '',
    });
    await queryInterface.addIndex('wattmatch_auction_bids', ['auction_id', 'prev_hash'], {
      unique: true,
      name: 'wattmatch_auction_bids_auction_prev_hash_unique',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('wattmatch_auction_bids', 'wattmatch_auction_bids_auction_prev_hash_unique');
    await queryInterface.changeColumn('wattmatch_auction_bids', 'prev_hash', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },
};
