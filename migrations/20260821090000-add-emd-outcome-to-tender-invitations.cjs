'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_tender_invitations', 'emd_outcome', {
      type: Sequelize.ENUM('pending', 'refunded', 'forfeited'),
      allowNull: false,
      defaultValue: 'pending',
    });
    await queryInterface.addColumn('wattmatch_tender_invitations', 'emd_outcome_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_tender_invitations', 'emd_outcome_reason', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_tender_invitations', 'emd_outcome_reason');
    await queryInterface.removeColumn('wattmatch_tender_invitations', 'emd_outcome_at');
    await queryInterface.removeColumn('wattmatch_tender_invitations', 'emd_outcome');
  },
};
