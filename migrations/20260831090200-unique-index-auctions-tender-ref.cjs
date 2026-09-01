'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('wattmatch_auctions', ['tender_ref'], {
      unique: true,
      name: 'wattmatch_auctions_tender_ref_unique',
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex('wattmatch_auctions', 'wattmatch_auctions_tender_ref_unique');
  },
};
