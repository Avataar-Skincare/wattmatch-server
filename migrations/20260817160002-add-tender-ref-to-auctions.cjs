'use strict';

// Nullable and additive — existing auctions (seeded manually, no tender behind them) simply have
// null here. Only auctions created via the vetting->auction bridge populate it.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_auctions', 'tender_ref', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_auctions', 'tender_ref');
  },
};
