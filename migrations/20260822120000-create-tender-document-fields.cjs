'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_tender_document_fields', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      tender_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      envelope: { type: Sequelize.ENUM('technical', 'financial'), allowNull: false },
      key: { type: Sequelize.STRING, allowNull: false },
      label: { type: Sequelize.STRING, allowNull: false },
      required: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      template_s3_key: { type: Sequelize.STRING, allowNull: true },
      template_original_filename: { type: Sequelize.STRING, allowNull: true },
      sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('wattmatch_tender_document_fields', ['tender_id']);
    await queryInterface.addConstraint('wattmatch_tender_document_fields', {
      fields: ['tender_id', 'key'],
      type: 'unique',
      name: 'tender_document_fields_tender_id_key_unique',
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_tender_document_fields');
  },
};
