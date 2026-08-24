'use strict';

const PRICING_STUB_DEFAULT_PAISE = 100; // ₹1 — matches pricingService.ts's old flat placeholder

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_tenders', 'rfs_document_fee_paise', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: PRICING_STUB_DEFAULT_PAISE,
    });
    await queryInterface.addColumn('wattmatch_tenders', 'bid_processing_fee_paise', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: PRICING_STUB_DEFAULT_PAISE,
    });
    await queryInterface.addColumn('wattmatch_tenders', 'emd_amount_paise', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: PRICING_STUB_DEFAULT_PAISE,
    });
    await queryInterface.addColumn('wattmatch_tenders', 'success_charge_paise', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: PRICING_STUB_DEFAULT_PAISE,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_tenders', 'rfs_document_fee_paise');
    await queryInterface.removeColumn('wattmatch_tenders', 'bid_processing_fee_paise');
    await queryInterface.removeColumn('wattmatch_tenders', 'emd_amount_paise');
    await queryInterface.removeColumn('wattmatch_tenders', 'success_charge_paise');
  },
};
