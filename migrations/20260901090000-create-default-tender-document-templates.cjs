'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_default_tender_document_templates', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      envelope: { type: Sequelize.ENUM('technical', 'financial'), allowNull: false },
      key: { type: Sequelize.STRING, allowNull: false, unique: true },
      template_s3_key: { type: Sequelize.STRING, allowNull: false },
      template_original_filename: { type: Sequelize.STRING, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_default_tender_document_templates');
  },
};
