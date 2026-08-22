'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_organization_tokens', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      organization_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      purpose: { type: Sequelize.ENUM('email_verification', 'password_reset'), allowNull: false },
      token_hash: { type: Sequelize.STRING, allowNull: false, unique: true },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      used_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('wattmatch_organization_tokens', ['organization_id', 'purpose']);
  },
  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_organization_tokens');
  },
};
