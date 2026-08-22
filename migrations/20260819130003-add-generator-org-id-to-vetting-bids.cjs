'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_vetting_bids', 'generator_org_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_vetting_bids', 'generator_org_id');
  },
};
