'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_invoices', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      payment_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, unique: true },
      invoice_number: { type: Sequelize.STRING, allowNull: false, unique: true },
      issued_at: { type: Sequelize.DATE, allowNull: false },
      seller_name: { type: Sequelize.STRING, allowNull: false },
      seller_gstin: { type: Sequelize.STRING, allowNull: true },
      buyer_name: { type: Sequelize.STRING, allowNull: true },
      buyer_email: { type: Sequelize.STRING, allowNull: true },
      amount_paise: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      currency: { type: Sequelize.STRING, allowNull: false },
      s3_key: { type: Sequelize.STRING, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_invoices');
  },
};
