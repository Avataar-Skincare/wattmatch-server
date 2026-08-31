'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_vetting_custodians', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      name: { type: Sequelize.STRING, allowNull: false },
      email: { type: Sequelize.STRING, allowNull: false, unique: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable('wattmatch_vetting_custodian_tokens', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      custodian_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      tender_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      envelope: { type: Sequelize.ENUM('technical', 'financial'), allowNull: false },
      token_hash: { type: Sequelize.STRING, allowNull: false, unique: true },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      used_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addConstraint('wattmatch_vetting_custodian_tokens', {
      fields: ['custodian_id', 'tender_id', 'envelope'],
      type: 'unique',
      name: 'vetting_custodian_tokens_custodian_tender_envelope_unique',
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_vetting_custodian_tokens');
    await queryInterface.dropTable('wattmatch_vetting_custodians');
  },
};
