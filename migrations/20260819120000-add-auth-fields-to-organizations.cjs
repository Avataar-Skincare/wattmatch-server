'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_organizations', 'password_hash', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_organizations', 'email_verified', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('wattmatch_organizations', 'email_verified_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addConstraint('wattmatch_organizations', {
      fields: ['contact_email'],
      type: 'unique',
      name: 'wattmatch_organizations_contact_email_unique',
    });
  },
  async down(queryInterface) {
    await queryInterface.removeConstraint('wattmatch_organizations', 'wattmatch_organizations_contact_email_unique');
    await queryInterface.removeColumn('wattmatch_organizations', 'email_verified_at');
    await queryInterface.removeColumn('wattmatch_organizations', 'email_verified');
    await queryInterface.removeColumn('wattmatch_organizations', 'password_hash');
  },
};
