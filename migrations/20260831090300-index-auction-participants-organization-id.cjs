'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('wattmatch_auction_participants', ['organization_id'], {
      name: 'wattmatch_auction_participants_organization_id',
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex('wattmatch_auction_participants', 'wattmatch_auction_participants_organization_id');
  },
};
