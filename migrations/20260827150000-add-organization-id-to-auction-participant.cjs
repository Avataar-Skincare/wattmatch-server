'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_auction_participants', 'organization_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_auction_participants', 'organization_id');
  },
};
