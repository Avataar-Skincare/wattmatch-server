'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_tenders', 'bid_submission_deadline', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_tenders', 'technical_bid_open_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_tenders', 'financial_bid_open_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_tenders', 'bid_submission_deadline');
    await queryInterface.removeColumn('wattmatch_tenders', 'technical_bid_open_at');
    await queryInterface.removeColumn('wattmatch_tenders', 'financial_bid_open_at');
  },
};
