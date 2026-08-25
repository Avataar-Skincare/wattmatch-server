'use strict';

// Success Charge is dropped from the platform (business decision, 2026-08-25) and EMD moved off
// Razorpay entirely onto a document-based flow (see EmdSubmission) — the invitation-level outcome
// tracking these columns held is superseded by EmdSubmission.status, so this drops both rather than
// leaving dead columns no code path writes any more. No production data exists yet, so this is a
// clean removal, not a backward-compatible migration.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.removeColumn('wattmatch_tenders', 'success_charge_paise');

    await queryInterface.removeColumn('wattmatch_tender_invitations', 'emd_outcome_reason');
    await queryInterface.removeColumn('wattmatch_tender_invitations', 'emd_outcome_at');
    await queryInterface.removeColumn('wattmatch_tender_invitations', 'emd_outcome');

    // Pre-production test/dev rows only — no real payments exist for these two purposes, so this is
    // a safe cleanup ahead of narrowing the ENUM below (MySQL rejects an ENUM change that would
    // leave existing rows holding a now-invalid value).
    await queryInterface.sequelize.query(
      "DELETE FROM wattmatch_payments WHERE purpose IN ('emd', 'success_charge')"
    );
    await queryInterface.changeColumn('wattmatch_payments', 'purpose', {
      type: Sequelize.ENUM('rfs_document', 'bid_processing'),
      allowNull: false,
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('wattmatch_payments', 'purpose', {
      type: Sequelize.ENUM('rfs_document', 'bid_processing', 'emd', 'success_charge'),
      allowNull: false,
    });

    await queryInterface.addColumn('wattmatch_tender_invitations', 'emd_outcome', {
      type: Sequelize.ENUM('pending', 'refunded', 'forfeited'),
      allowNull: false,
      defaultValue: 'pending',
    });
    await queryInterface.addColumn('wattmatch_tender_invitations', 'emd_outcome_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_tender_invitations', 'emd_outcome_reason', {
      type: Sequelize.STRING,
      allowNull: true,
    });

    await queryInterface.addColumn('wattmatch_tenders', 'success_charge_paise', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 100,
    });
  },
};
