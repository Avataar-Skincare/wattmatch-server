'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_vetting_decided_records', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      vetting_bid_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      envelope: { type: Sequelize.ENUM('technical', 'financial'), allowNull: false },
      encrypted_content: { type: Sequelize.TEXT, allowNull: false },
      decided_at: { type: Sequelize.DATE, allowNull: false },
      retention_purge_after: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('wattmatch_vetting_decided_records', ['vetting_bid_id', 'envelope']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_vetting_decided_records');
  },
};
