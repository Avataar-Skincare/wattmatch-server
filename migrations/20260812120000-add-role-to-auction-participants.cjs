'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_auction_participants', 'role', {
      type: Sequelize.ENUM('generator', 'buyer'),
      allowNull: false,
      defaultValue: 'generator',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_auction_participants', 'role');
  },
};
