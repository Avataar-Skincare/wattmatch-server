'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_vetting_bids', 'technical_opened_content', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_vetting_bids', 'financial_opened_content', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_vetting_bids', 'technical_opened_content');
    await queryInterface.removeColumn('wattmatch_vetting_bids', 'financial_opened_content');
  },
};
