'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_ci_registrations', 'consent_given', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('wattmatch_ci_registrations', 'consent_given_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_ci_registrations', 'consent_given');
    await queryInterface.removeColumn('wattmatch_ci_registrations', 'consent_given_at');
  },
};
