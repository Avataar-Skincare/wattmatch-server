'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_auctions', 'min_undercut', {
      type: Sequelize.DECIMAL(10, 4),
      allowNull: false,
      defaultValue: 0.01,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_auctions', 'min_undercut');
  },
};
