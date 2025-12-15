/*global QUnit*/

sap.ui.define([
	"inboundlabel/controller/InboundLabel.controller"
], function (Controller) {
	"use strict";

	QUnit.module("InboundLabel Controller");

	QUnit.test("I should test the InboundLabel controller", function (assert) {
		var oAppController = new Controller();
		oAppController.onInit();
		assert.ok(oAppController);
	});

});
