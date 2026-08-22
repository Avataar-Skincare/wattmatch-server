'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_vetting_bids', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      tender_ref: { type: Sequelize.STRING, allowNull: false },
      applicant_alias: { type: Sequelize.STRING, allowNull: false },

      technical_wrapped_key: { type: Sequelize.TEXT, allowNull: false },
      technical_iv: { type: Sequelize.STRING, allowNull: false },
      technical_ciphertext: { type: Sequelize.TEXT, allowNull: false },
      technical_ciphertext_hash: { type: Sequelize.STRING, allowNull: false },

      financial_wrapped_key: { type: Sequelize.TEXT, allowNull: false },
      financial_iv: { type: Sequelize.STRING, allowNull: false },
      financial_ciphertext: { type: Sequelize.TEXT, allowNull: false },
      financial_ciphertext_hash: { type: Sequelize.STRING, allowNull: false },

      technical_status: { type: Sequelize.ENUM('pending', 'approved', 'rejected'), allowNull: false, defaultValue: 'pending' },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('wattmatch_vetting_bids', ['tender_ref']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_vetting_bids');
  },
};
