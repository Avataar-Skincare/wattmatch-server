'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_tenders', 'rfs_document_s3_key', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_tenders', 'rfs_document_original_filename', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_tenders', 'tender_document_s3_key', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_tenders', 'tender_document_original_filename', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_tenders', 'rfs_document_s3_key');
    await queryInterface.removeColumn('wattmatch_tenders', 'rfs_document_original_filename');
    await queryInterface.removeColumn('wattmatch_tenders', 'tender_document_s3_key');
    await queryInterface.removeColumn('wattmatch_tenders', 'tender_document_original_filename');
  },
};
