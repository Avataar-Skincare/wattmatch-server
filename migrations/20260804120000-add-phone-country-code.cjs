'use strict';

const TABLES = [
  'wattmatch_ci_leads',
  'wattmatch_generator_leads',
  'wattmatch_ci_registrations',
  'wattmatch_generator_registrations',
];

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const table of TABLES) {
      await queryInterface.addColumn(table, 'phone_country_code', {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: '+91',
      });
    }
  },

  async down(queryInterface) {
    for (const table of TABLES) {
      await queryInterface.removeColumn(table, 'phone_country_code');
    }
  },
};
