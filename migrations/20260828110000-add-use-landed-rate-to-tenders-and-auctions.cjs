'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_tenders', 'use_landed_rate', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('wattmatch_auctions', 'use_landed_rate', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_tenders', 'use_landed_rate');
    await queryInterface.removeColumn('wattmatch_auctions', 'use_landed_rate');
  },
};
