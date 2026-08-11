'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_auction_bids', 'prev_hash', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    // Temporarily nullable so existing rows (seeded before this migration) don't block the
    // column add; backfilled below, then tightened to NOT NULL for all new rows going forward.
    await queryInterface.addColumn('wattmatch_auction_bids', 'hash', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.sequelize.query(
      "UPDATE wattmatch_auction_bids SET hash = 'unchained-pre-migration' WHERE hash IS NULL"
    );
    await queryInterface.changeColumn('wattmatch_auction_bids', 'hash', {
      type: Sequelize.STRING,
      allowNull: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_auction_bids', 'hash');
    await queryInterface.removeColumn('wattmatch_auction_bids', 'prev_hash');
  },
};
