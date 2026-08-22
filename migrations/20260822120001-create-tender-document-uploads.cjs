'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_tender_document_uploads', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      tender_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      organization_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      field_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      s3_key: { type: Sequelize.STRING, allowNull: false },
      original_filename: { type: Sequelize.STRING, allowNull: false },
      size_bytes: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('wattmatch_tender_document_uploads', ['tender_id']);
    await queryInterface.addConstraint('wattmatch_tender_document_uploads', {
      fields: ['field_id', 'organization_id'],
      type: 'unique',
      name: 'tender_document_uploads_field_id_org_id_unique',
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_tender_document_uploads');
  },
};
