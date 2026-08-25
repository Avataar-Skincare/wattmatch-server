'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_emd_submissions', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      tender_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      organization_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },

      bank_name: { type: Sequelize.STRING, allowNull: false },
      guarantee_number: { type: Sequelize.STRING, allowNull: false },
      amount_paise: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      valid_upto: { type: Sequelize.DATEONLY, allowNull: false },

      document_s3_key: { type: Sequelize.STRING, allowNull: false },
      document_original_filename: { type: Sequelize.STRING, allowNull: false },

      return_recipient_name: { type: Sequelize.STRING, allowNull: false },
      return_address_line: { type: Sequelize.STRING, allowNull: false },
      return_city: { type: Sequelize.STRING, allowNull: false },
      return_state: { type: Sequelize.STRING, allowNull: false },
      return_pincode: { type: Sequelize.STRING, allowNull: false },
      return_phone: { type: Sequelize.STRING, allowNull: false },

      status: { type: Sequelize.ENUM('submitted', 'released', 'invoked'), allowNull: false, defaultValue: 'submitted' },
      resolved_at: { type: Sequelize.DATE, allowNull: true },
      resolved_reason: { type: Sequelize.STRING, allowNull: true },
      dispatch_reference: { type: Sequelize.STRING, allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addConstraint('wattmatch_emd_submissions', {
      fields: ['tender_id', 'organization_id'],
      type: 'unique',
      name: 'emd_submissions_tender_id_org_id_unique',
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_emd_submissions');
  },
};
