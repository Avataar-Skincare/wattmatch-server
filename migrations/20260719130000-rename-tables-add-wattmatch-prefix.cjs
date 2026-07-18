'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.renameTable('ci_leads', 'wattmatch_ci_leads');
    await queryInterface.renameTable('generator_leads', 'wattmatch_generator_leads');
    await queryInterface.renameTable('contact_messages', 'wattmatch_contact_messages');
  },

  async down(queryInterface) {
    await queryInterface.renameTable('wattmatch_ci_leads', 'ci_leads');
    await queryInterface.renameTable('wattmatch_generator_leads', 'generator_leads');
    await queryInterface.renameTable('wattmatch_contact_messages', 'contact_messages');
  },
};
