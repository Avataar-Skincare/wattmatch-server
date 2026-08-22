'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_payments', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      purpose: { type: Sequelize.ENUM('rfs_document', 'bid_processing', 'emd', 'success_charge'), allowNull: false },
      tender_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      organization_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
      payer_name: { type: Sequelize.STRING, allowNull: true },
      payer_email: { type: Sequelize.STRING, allowNull: true },

      razorpay_order_id: { type: Sequelize.STRING, allowNull: false, unique: true },
      razorpay_payment_id: { type: Sequelize.STRING, allowNull: true, unique: true },
      razorpay_signature: { type: Sequelize.STRING, allowNull: true },

      amount_paise: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      currency: { type: Sequelize.STRING, allowNull: false },
      status: {
        type: Sequelize.ENUM('created', 'attempted', 'paid', 'failed', 'refunded'),
        allowNull: false,
        defaultValue: 'created',
      },

      notes: { type: Sequelize.JSON, allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('wattmatch_payments', ['tender_id']);
    await queryInterface.addIndex('wattmatch_payments', ['organization_id']);
  },
  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_payments');
  },
};
