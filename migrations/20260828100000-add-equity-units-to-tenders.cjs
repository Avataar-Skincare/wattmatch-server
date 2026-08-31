'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_tenders', 'equity_value', {
      type: Sequelize.DECIMAL(14, 2),
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_tenders', 'total_units_per_year', {
      type: Sequelize.DECIMAL(14, 2),
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_tenders', 'equity_value');
    await queryInterface.removeColumn('wattmatch_tenders', 'total_units_per_year');
  },
};
