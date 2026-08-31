'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_auction_bids', 'rate', {
      type: Sequelize.DECIMAL(10, 4),
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_auction_bids', 'return_percent', {
      type: Sequelize.DECIMAL(5, 2),
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_auction_bids', 'rate');
    await queryInterface.removeColumn('wattmatch_auction_bids', 'return_percent');
  },
};
