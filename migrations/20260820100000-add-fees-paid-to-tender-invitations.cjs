'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_tender_invitations', 'fees_paid', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('wattmatch_tender_invitations', 'fees_paid_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_tender_invitations', 'fees_paid_at');
    await queryInterface.removeColumn('wattmatch_tender_invitations', 'fees_paid');
  },
};
