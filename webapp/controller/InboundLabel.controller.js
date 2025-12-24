sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/model/json/JSONModel"
], function (Controller, MessageToast, MessageBox, JSONModel) {
    "use strict";

    return Controller.extend("inboundlabel.controller.InboundLabel", {

        onInit: function () {
            const oVM = new JSONModel({
                HuData: "",
                Warehouse: "1050",

                rfExtras: {
                    CO: "",
                    VLot: "",
                    P1: "",
                    F1: ""
                },

                huDetails: null,

                // aggregated data from multiple APIs
                agg: {
                    hu: null,
                    huItem: null,
                    ibdHeader: null,
                    ibdItem: null,
                    po: null,
                    docFlow: null,
                    matDocItem: null
                },

                isLoading: false
            });

            this.getView().setModel(oVM, "view");
        },
onHuSubmit: function (oEvent) {
    const sHu = oEvent.getParameter("value");
    if (sHu) this._startHuFlow(sHu);
},

onHuChange: function (oEvent) {
    const sHu = oEvent.getParameter("value");
    if (sHu && sHu.length >= 9) this._startHuFlow(sHu);
},

_startHuFlow: async function (sHu) {
    const oVM = this.getView().getModel("view");

    try {
        sap.ui.core.BusyIndicator.show(0);
        console.log("Starting HU → IBD → PO → DocFlow → MatDoc pipeline");

        // --------------------------
        // 1 FETCH HU DETAILS
        // --------------------------
        const hu = await this._fetchHUDetails(sHu);
        if (!hu) throw new Error("HU fetch failed. Stopping pipeline.");

        console.log("HU OK →", hu);
        oVM.setProperty("/huDetails", hu);

        // Extract IBD number from HU
        const ibd = hu.HandlingUnitReferenceDocument;
        if (!ibd) throw new Error("IBD missing inside HU response");

        console.log("IBD extracted:", ibd);
        oVM.setProperty("/ibd", ibd); // raw number (if you want it)

        // --------------------------
        // 2️ FETCH INBOUND DELIVERY ITEMS
        // --------------------------
        const ibdItems = await this._fetchInboundDelivery(ibd);
        if (!ibdItems || ibdItems.length === 0) {
            throw new Error("No Inbound Delivery Items returned.");
        }

        console.log("IBD Items OK →", ibdItems);
        oVM.setProperty("/ibdItems", ibdItems);

        // take first item for payload usage
        const firstItem = ibdItems[0];
        oVM.setProperty("/ibdDetails", firstItem);   // ⬅ this is what onPrintProgram expects

        // --------------------------
        // 3️ FETCH PO USING IBD → ReferenceSDDocument
        // --------------------------
        const poNumber = firstItem.ReferenceSDDocument;
        if (poNumber) {
            console.log("Fetching PO:", poNumber);

            const poDetails = await this._fetchPO(poNumber);  // returns { purchaseOrder, firstItem }

            console.log("PO OK →", poDetails);
            oVM.setProperty("/poDetails", poDetails);

        } else {
            console.warn("No PO found in IBD Item");
        }

        // --------------------------
        // 4️ FETCH DOCUMENT FLOW
        // --------------------------
        console.log(`Calling DocFlow for IBD=${ibd}, Item=${firstItem.DeliveryDocumentItem}`);

        const docFlow = await this._fetchDocumentFlow(
            ibd,
            firstItem.DeliveryDocumentItem
        );

        if (!docFlow) {
            throw new Error("Document Flow is empty");
        }

        console.log("DOC FLOW ENTRY →", docFlow);
        oVM.setProperty("/docFlow", docFlow);

        // --------------------------
        // 5️ EXTRACT MATERIAL DOCUMENT FROM DOC FLOW
        // --------------------------
        const matDocInfo = this._extractMaterialDocument(docFlow);

        if (!matDocInfo) {
            console.warn("No Material Document found in Document Flow");
            oVM.setProperty("/matDoc", null);
        } else {
            console.log("Material Doc Keys:", matDocInfo);

            // --------------------------
            // 6️ FETCH MATERIAL DOCUMENT ITEM
            // --------------------------


            
            const matDocItem = await this._fetchMaterialDocumentItem(
                matDocInfo.MaterialDocument,
                matDocInfo.Year,
                matDocInfo.MaterialDocumentItem
            );

            console.log("MATERIAL DOCUMENT ITEM OK:", matDocItem);
            oVM.setProperty("/matDoc", matDocItem);
        }

        sap.m.MessageToast.show("All data loaded successfully!");

    } catch (err) {
        console.error("Pipeline Error →", err);
        sap.m.MessageBox.error(err.message);

    } finally {
        sap.ui.core.BusyIndicator.hide();
    }
},   //---------------------------------------------------------------------
        // HU READ (V4)
        //---------------------------------------------------------------------
 _fetchHUDetails: async function (sHu) {
    const oVM = this.getView().getModel("view");

    try {
        const oModel = this.getView().getModel("huService");

        const warehouse = "1050";

        const sPath =
            `/HandlingUnit(HandlingUnitExternalID='${sHu}',Warehouse='${warehouse}')` +
            `?$expand=_HandlingUnitItem`;

        console.log("HU PATH →", sPath);

        const ctx = oModel.bindContext(sPath, null, { "$$groupId": "$direct" });
        const data = await ctx.requestObject();

        if (!data) throw new Error("HU returned empty dataset");

        oVM.setProperty("/huDetails", data);
        this._populateFieldsFromHU(data);

        return data;

    } catch (e) {
        console.error("HU Error:", e);
        throw e;
    }
},

_fetchPO: async function (poNumber) {
   try {
        const oVM = this.getView().getModel("view");
        const poModel = this.getView().getModel("poService");

        if (!poModel) throw new Error("PO Model missing — check manifest");

        const sPath = `/PurchaseOrder('${poNumber}')?$expand=_PurchaseOrderItem`;
        console.log("PO PATH →", sPath);

        const ctx = poModel.bindContext(sPath);
        const poData = await ctx.requestObject();

        if (!poData || !poData._PurchaseOrderItem || poData._PurchaseOrderItem.length === 0) {
            throw new Error("No PO items returned");
        }

        const firstItem = poData._PurchaseOrderItem[0];

        const result = {
            purchaseOrder: poData,
            firstItem: firstItem
        };

        // Save to model (for debugging / later use)
        oVM.setProperty("/poDetails", result);

        console.log("Saved PO Details →", result);

        return result;

    } catch (err) {
        console.error("PO Fetch Error:", err);
        sap.m.MessageBox.error(err.message);
        return null;
    }
},
_fetchDocumentFlow: function (deliveryNumber, deliveryItem) {
    return new Promise((resolve, reject) => {
        const oModel = this.getView().getModel("ibdService");

        if (!oModel) {
            return reject("Inbound Delivery model missing");
        }

        const sPath =
            "/A_InbDeliveryItem(DeliveryDocument='" +
            deliveryNumber +
            "',DeliveryDocumentItem='" +
            deliveryItem +
            "')/to_DocumentFlow";

        console.log("DocFlow PATH →", sPath);

        oModel.read(sPath, {
            success: function (oData) {
                if (!oData || !oData.results || oData.results.length === 0) {
                    return reject("No Document Flow data returned");
                }

                console.log("DOC FLOW FULL ARRAY →", oData.results);

                // RETURN FULL ARRAY
                resolve(oData.results);
            },
            error: function (err) {
                console.error("DocFlow Fetch Error:", err);
                reject(err);
            }
        });
    });
},

 _populateFieldsFromHU: function (oHu) {
            if (!oHu) return;

            const oVM = this.getView().getModel("view");

            oVM.setProperty("/rfExtras/CO",
                oHu.HandlingUnitInternalID || oVM.getProperty("/rfExtras/CO"));
        },

        //---------------------------------------------------------------------
        // IBD READ (V2)
        //---------------------------------------------------------------------
  _readV2EntitySet: function (oModel, sPath, mParams) {
            return new Promise((resolve, reject) => {
                oModel.read(sPath, {
                    urlParameters: mParams || {},
                    success: oData => resolve(oData.results || oData),
                    error: reject
                });
            });
        },

    _fetchInboundDelivery: async function (ibd) {
    const oModel = this.getView().getModel("ibdService");

    const path = `/A_InbDeliveryHeader('${ibd}')/to_DeliveryDocumentItem`;

    console.log("IBD PATH →", path);

    return new Promise((resolve, reject) => {
        oModel.read(path, {
            success: function (data) {
                console.log("IBD RESPONSE →", data);
                resolve(data.results);
            },
            error: reject
        });
    });
   },

     // Correctly extract Material Document entry
_extractMaterialDocument: function (docFlowOrArray) {
    if (!docFlowOrArray) return null;

    // Normalize to array
    const arr = Array.isArray(docFlowOrArray) ? docFlowOrArray : [docFlowOrArray];

    // ONLY Material Document = Category 'R'
    const entry = arr.find(e => e.SubsequentDocumentCategory == "R");

    if (!entry) {
        console.warn("No Material Document found based on SubsequentDocumentCategory = 'R'");
        return null;
    }

    const rawItem = entry.SubsequentDocumentItem || "000001";

    return {
        MaterialDocument: entry.SubsequentDocument,
        // SAP inconsistency fix: 6-digit → 4-digit
        MaterialDocumentItem: rawItem.slice(-4),
        Year: entry.SubsequentDocumentYear || new Date().getFullYear()
    };
},

        //---------------------------------------------------------------------
        // MATERIAL DOCUMENT ITEM (V2)
        //---------------------------------------------------------------------
_fetchMaterialDocumentItem: async function (doc, year, item) {
    const oModel = this.getView().getModel("matdocService");
    const oVM = this.getView().getModel("view");

    if (!oModel) throw "Material Document model missing";

    const docYear = year || new Date().getFullYear().toString();

    // ----------------------------------------
    // 1️⃣ Fetch HEADER (CreationDate)
    // ----------------------------------------
    const headerPath =
        `/A_MaterialDocumentHeader(MaterialDocument='${doc}',MaterialDocumentYear='${docYear}')`;

    console.log("MatDoc HEADER PATH →", headerPath);

    const headerData = await new Promise((resolve, reject) => {
        oModel.read(headerPath, {
            success: resolve,
            error: reject
        });
    });

    // ----------------------------------------
    // 2️⃣ Fetch ITEM (QuantityInBaseUnit)
    // ----------------------------------------
    const itemPath =
        `/A_MaterialDocumentItem(MaterialDocument='${doc}',MaterialDocumentYear='${docYear}',MaterialDocumentItem='${item}')`;

    console.log("MatDoc ITEM PATH →", itemPath);

    const itemData = await new Promise((resolve, reject) => {
        oModel.read(itemPath, {
            success: resolve,
            error: reject
        });
    });

    // ----------------------------------------
    // COMBINE BOTH RESULTS
    // ----------------------------------------
    const combined = {
        CreationDate: headerData.CreationDate,
        QuantityInBaseUnit: itemData.QuantityInBaseUnit,
        DocumentNo : itemData.MaterialDocument,
        RawHeader: headerData,
        RawItem: itemData
    };

    console.log("FINAL MATERIAL DOC DATA →", combined);

    oVM.setProperty("/matDoc", combined);

    return combined;
},

        //---------------------------------------------------------------------
        // PURCHASE ORDER LOADER (From your old project)
        //---------------------------------------------------------------------
 loadPurchaseOrderData: async function (model, purchaseOrderNumber) {
            try {
                const po = await this.getPurchaseOrder(model, purchaseOrderNumber);
                const items = await this.getPurchaseOrderItems(model, purchaseOrderNumber);

                return {
                    purchaseOrder: po,
                    items,
                    firstItem: items[0]
                };
            } catch (e) {
                console.error("PO load failed:", e);
                return null;
            }
        },

        //---------------------------------------------------------------------
        // CLEAR BUTTON
        //---------------------------------------------------------------------
        onChangeData: function () {
            const oVM = this.getView().getModel("view");

            oVM.setProperty("/HuData", "");
            oVM.setProperty("/rfExtras", { CO: "", VLot: "", P1: "", F1: "" });
            oVM.setProperty("/agg", {});

            // MessageToast.show("Cleared");

          //  this.onpresss()
            
        },


onPrintProgram: async function () {
    try {
        const oVM = this.getView().getModel("view");
        const data = oVM.getData();

        // -----------------------------
        // 1. VALIDATIONS
        // -----------------------------
        if (!data.HuData) return sap.m.MessageBox.error("Enter Handling Unit");
        if (!data.Warehouse) return sap.m.MessageBox.error("Enter Warehouse");
        if (!data.rfExtras.VLot) return sap.m.MessageBox.error("Enter EI#");
        if (!data.huDetails) return sap.m.MessageBox.error("HU details missing — fetch HU first.");
        if (!data.ibdDetails) return sap.m.MessageBox.error("Inbound Delivery missing");
        if (!data.poDetails) return sap.m.MessageBox.error("PO details missing");
        if (!data.docFlow) return sap.m.MessageBox.error("Document Flow missing");
        if (!data.matDoc) return sap.m.MessageBox.error("Material Document missing");

        sap.ui.core.BusyIndicator.show(0);

        const hu = data.huDetails;
        const ibd = data.ibdDetails;
        const po = data.poDetails.purchaseOrder;
        const poItem = data.poDetails.firstItem;
        const mat = data.matDoc;

        const huItem = hu._HandlingUnitItem?.[0] || {};

        // -----------------------------
        // 2. BUILD PAYLOAD
        // -----------------------------
        const payload = {
            Order_HU: {
                HU: data.HuData,
                barcode: data.HuData,

                Pack_Material: hu.PackagingMaterial || "",
                Product: huItem.Material || "",
                Prod_Desc: poItem.PurchaseOrderItemText || "",

                Hu_Quantity: huItem.HandlingUnitQuantity || "",
                Uom: huItem.HandlingUnitQuantityUnit || "",
                St_Type: hu.StorageType || "",
                Storage_Location: hu.StorageLocation || "",
                Storage_Bin: hu.StorageBin || "",
                Vendor_Code: po.Supplier || "",

                Delivery: ibd.DeliveryDocument || "",
                Delivery_Item: ibd.DeliveryDocumentItem || "",

                Exp_date: ibd.ShelfLifeExpirationDate || "",
                Manufacture_date: ibd.ManufactureDate || "",
                Batch: ibd.Batch || "",

                Stock_Category: poItem?.StockType === "X" ? "X" : "",
                Special_stock: poItem?.PurchaseOrderCategory === "K" ? "K" : "",

                Purchase_Order: po.PurchaseOrder || "",
                PO_Item: poItem.PurchaseOrderItem || "",
                Vendor_Part: poItem.ManufacturerMaterial || "",

                Prod_Order: "",
                Int_Serialno: "",

                GR: mat.DocumentNo || "",
                GR_Qty: mat.QuantityInBaseUnit || "",
                GR_Date: mat.CreationDate || "",

                CO: data.rfExtras.CO,
                IE: data.rfExtras.VLot,
                Label_Format: data.rfExtras.P1,
                Printer: data.rfExtras.F1,
                Box: data.rfExtras.Box || ""
            }
        };

        console.log("📦 FINAL CPI PAYLOAD →", payload);

        // -----------------------------
        // 3. CPI CALL (CORRECT FORMAT)
        // -----------------------------
        const sBaseUrl = sap.ui.require.toUrl("inboundlabel"); // app namespace
        const sUrl = sBaseUrl + "/http/Bartender/Order";

        const oResponse = await fetch(sUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        if (oResponse.ok) {
            sap.m.MessageBox.success(
                "Label printed successfully.",
                {
                    title: "Print Successful",
                    onClose: () => {
                        this.onChangeData(); // clear AFTER success
                    }
                }
            );
        } else {
            const errText = await oResponse.text();
            console.error("❌ CPI Error:", errText);
            sap.m.MessageBox.error(errText || "Error calling CPI");
        }

    } catch (err) {
        console.error("❌ CPI Exception:", err);
        sap.m.MessageBox.error(err.message);
    } finally {
        sap.ui.core.BusyIndicator.hide();
    }
},

 });

    
});