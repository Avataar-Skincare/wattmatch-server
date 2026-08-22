'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_payments', 'payer_company', { type: Sequelize.STRING, allowNull: true });
    await queryInterface.addColumn('wattmatch_payments', 'payer_designation', { type: Sequelize.STRING, allowNull: true });
    await queryInterface.addColumn('wattmatch_payments', 'payer_mobile', { type: Sequelize.STRING, allowNull: true });
    await queryInterface.addColumn('wattmatch_payments', 'payer_is_generator', { type: Sequelize.BOOLEAN, allowNull: true });
    // DPDP Act (Red Flag #1, TENDER_WORKFLOW_STAKEHOLDER_PLAN.md): recorded server-side, not just
    // gated client-side, so there's real evidence consent was actually given at this timestamp —
    // relying on the frontend checkbox alone would leave no record if it were ever disputed.
    await queryInterface.addColumn('wattmatch_payments', 'consent_given_at', { type: Sequelize.DATE, allowNull: true });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_payments', 'payer_company');
    await queryInterface.removeColumn('wattmatch_payments', 'payer_designation');
    await queryInterface.removeColumn('wattmatch_payments', 'payer_mobile');
    await queryInterface.removeColumn('wattmatch_payments', 'payer_is_generator');
    await queryInterface.removeColumn('wattmatch_payments', 'consent_given_at');
  },
};
