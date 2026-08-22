'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_organizations', 'capacity_mw', {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_organizations', 'capacity_mw');
  },
};
