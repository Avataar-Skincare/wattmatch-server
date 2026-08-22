'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_tender_invitations', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      tender_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      organization_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      status: { type: Sequelize.ENUM('invited', 'accepted', 'declined'), allowNull: false, defaultValue: 'invited' },
      invited_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      responded_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addConstraint('wattmatch_tender_invitations', {
      fields: ['tender_id', 'organization_id'],
      type: 'unique',
      name: 'wattmatch_tender_invitations_tender_org_unique',
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_tender_invitations');
  },
};
