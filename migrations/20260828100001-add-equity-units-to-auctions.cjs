'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_auctions', 'equity_value', {
      type: Sequelize.DECIMAL(14, 2),
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_auctions', 'total_units_per_year', {
      type: Sequelize.DECIMAL(14, 2),
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_auctions', 'equity_value');
    await queryInterface.removeColumn('wattmatch_auctions', 'total_units_per_year');
  },
};
