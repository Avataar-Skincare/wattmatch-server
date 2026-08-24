'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('wattmatch_organizations', 'type', {
      type: Sequelize.ENUM('buyer', 'generator', 'admin'),
      allowNull: false,
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('wattmatch_organizations', 'type', {
      type: Sequelize.ENUM('buyer', 'generator'),
      allowNull: false,
    });
  },
};
