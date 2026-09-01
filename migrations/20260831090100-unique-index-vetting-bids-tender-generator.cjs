'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('wattmatch_vetting_bids', ['tender_ref', 'generator_org_id'], {
      unique: true,
      name: 'wattmatch_vetting_bids_tender_ref_generator_org_id_unique',
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex('wattmatch_vetting_bids', 'wattmatch_vetting_bids_tender_ref_generator_org_id_unique');
  },
};
