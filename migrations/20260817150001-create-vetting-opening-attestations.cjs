'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_vetting_opening_attestations', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      tender_ref: { type: Sequelize.STRING, allowNull: false },
      envelope: { type: Sequelize.ENUM('technical', 'financial'), allowNull: false },
      opened_set_hash: { type: Sequelize.STRING, allowNull: false },
      share_fingerprint1: { type: Sequelize.STRING, allowNull: false },
      share_fingerprint2: { type: Sequelize.STRING, allowNull: false },
      is_emergency: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      emergency_justification: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('wattmatch_vetting_opening_attestations', ['tender_ref', 'envelope']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_vetting_opening_attestations');
  },
};
