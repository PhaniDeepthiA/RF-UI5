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
                Warehouse: "PU01",

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

            const oCountryModel = new sap.ui.model.json.JSONModel();
    oCountryModel.loadData("model/countries.json");
    this.getView().setModel(oCountryModel, "countryModel");
        },

onHuSubmit: function (oEvent) {
    const sHu = oEvent.getParameter("value");
   // if (sHu) this._startHuFlow(sHu);
   this._startIbdFlow(sHu);
},

//onHuChange: function (oEvent) {
//     const sHu = oEvent.getParameter("value");
//     if (sHu && sHu.length >= 9) this._startHuFlow(sHu);
// },

onAfterRendering: function () {
    // Warehouse
    this.byId("idWh").$().css("width", "7ch");
    this.byId("idWh").$().find("input").css("font-family", "monospace");

    // IE
    this.byId("idEI").$().css("width", "19ch");
    this.byId("idEI").$().find("input").css("font-family", "monospace");

    // CO
    this.byId("idCO").$().css("width", "3ch");
    this.byId("idCO").$().find("input").css("font-family", "monospace");

    // P
    this.byId("idP").$().css("width", "33ch");
    this.byId("idP").$().find("input").css("font-family", "monospace");

    // F
    this.byId("idF").$().css("width", "33ch");
    this.byId("idF").$().find("input").css("font-family", "monospace");
},
onCOChange: function (oEvent) {
    const oInput = oEvent.getSource();
    const oViewModel = this.getView().getModel("view");

    let sValue = oEvent.getParameter("value") || "";

    // Normalize to uppercase
    sValue = sValue.toUpperCase();

    // Enforce max length = 2
    if (sValue.length > 2) {
        sValue = sValue.substring(0, 2);
    }

    oInput.setValue(sValue);

    // Default: invalid until proven valid
    oViewModel.setProperty("/rfExtras/COValid", false);

    // Case 0 chars → neutral (user hasn't started)
    if (sValue.length === 0) {
        oInput.setValueState("None");
        return;
    }

    // Case 1 char → incomplete (invalid)
    if (sValue.length === 1) {
        oInput.setValueState("Error");
        oInput.setValueStateText("Enter 2-letter country code");
        return;
    }

    // Case 2 chars → validate against static country list
    const oCountryModel = this.getView().getModel("countryModel");
    const aCountries = oCountryModel?.getProperty("/countries") || [];

    const bValid = aCountries.some(function (c) {
        return c.code === sValue;
    });

    if (!bValid) {
        oInput.setValueState("Error");
        oInput.setValueStateText("Invalid Country Code");
        return;
    }

    // VALID
    oInput.setValueState("None");
    oViewModel.setProperty("/rfExtras/COValid", true);
},

_startIbdFlow: async function (ibd) {
    const oVM = this.getView().getModel("view");

    try {
        sap.ui.core.BusyIndicator.show(0);
        console.log("Starting IBD-driven flow:", ibd);

        // =================================================
        // 1️ Fetch IBD Items
        // =================================================
        const ibdItems = await this._fetchInboundDelivery(ibd);
        if (!ibdItems || !ibdItems.length) {
            throw new Error("No IBD items found");
        }

        const firstItem = ibdItems[0];
        oVM.setProperty("/ibdItems", ibdItems);
        oVM.setProperty("/ibdDetails", firstItem);

        // =================================================
        // 2️ PO vs Production Order
        // =================================================
        const isProdOrder = firstItem.DeliveryDocumentItemCategory === "DIGN";
        oVM.setProperty("/isProdOrder", isProdOrder);

        if (isProdOrder) {
            oVM.setProperty("/prodOrderDetails", {
                OrderID: firstItem.OrderID,
                OrderItem: firstItem.OrderItem
            });
        } else {
            const poNumber = firstItem.ReferenceSDDocument;
            if (!poNumber) {
                throw new Error("PO number missing in IBD");
            }

            const poDetails = await this._fetchPO(poNumber);
            oVM.setProperty("/poDetails", poDetails);
        }

        // =================================================
        // 3️ Document Flow → pick LATEST GR
        // =================================================
        const docFlow = await this._fetchDocumentFlow(
            ibd,
            firstItem.DeliveryDocumentItem
        );

        if (!Array.isArray(docFlow) || !docFlow.length) {
            throw new Error("Document Flow empty");
        }

        const grEntries = docFlow.filter(
            e => e.SubsequentDocumentCategory === "R"
        );

        if (!grEntries.length) {
            throw new Error("No Goods Receipt found for IBD");
        }

        // Pick latest GR numerically (SAP safe)
        const latestGR = grEntries.reduce((max, curr) =>
            Number(curr.SubsequentDocument) > Number(max.SubsequentDocument)
                ? curr
                : max
        );

        console.log("Latest GR selected:", latestGR.SubsequentDocument);

        // =================================================
        // 4️ Fetch Material Document (LATEST GR)
        // =================================================
        const matDoc = await this._fetchMaterialDocumentItem(
            latestGR.SubsequentDocument,
            latestGR.SubsequentDocumentYear || new Date().getFullYear().toString(),
            (latestGR.SubsequentDocumentItem || "0001").slice(-4)
        );

        oVM.setProperty("/matDoc", matDoc);

        console.log(
            "Latest GR timestamp:",
            new Date(matDoc.CreationDate).toISOString()
        );


// ------------------------------------------------
// 7️⃣ AUTO POPULATE COUNTRY OF ORIGIN (FIXED)
// ------------------------------------------------
const ibdItem = oVM.getProperty("/ibdDetails"); // THIS is the IBD item

const material = ibdItem?.Material;
const plant    = ibdItem?.Plant;

console.log(" Resolving COO for", { material, plant });

if (material && plant) {
    const country = await this._fetchCountryOfOrigin(material, plant);

    if (country) {
        this._applyAutoCO(country);
    } else {
        console.warn(
            ` COO not maintained for Material ${material} in Plant ${plant}`
        );
    }
} else {
    console.error(
        " Cannot resolve COO — Material or Plant missing",
        { material, plant }
    );
}

 // 7️ FETCH PRINTER / LAYOUT

// const sloc = ibdItem.StorageLocation;
// const printerCfg = await this._fetchPrinterLayout(plant, sloc);
// oVM.setProperty("/rfExtras/P1", printerCfg.Printer);
// oVM.setProperty("/rfExtras/F1", printerCfg.Layout);

// console.log("Printer/Layout resolved →", printerCfg);

 // =================================================
 // 5️ Fetch ALL HUs for IBD (CORRECT LOGIC)
// =================================================
     
const huList = await this._fetchHUsForInboundDelivery(ibd);

const latestHUs = this._getLatestHUs(huList);

oVM.setProperty("/huList", latestHUs);

console.log("fetched Hus are →", latestHUs);


console.log(
    `${latestHUs.length} latest HUs selected for GR ${matDoc.DocumentNo}`
);

    } catch (err) {
        console.error("IBD Flow failed", err);
        sap.m.MessageBox.error(err.message);
    } finally {
        sap.ui.core.BusyIndicator.hide();
    }
},

_fetchCountryOfOrigin: function (material, plant) {
    return new Promise((resolve, reject) => {
        const oModel = this.getView().getModel("apiProductService"); // API_PRODUCT_SRV

        const sPath = `/A_Product('${material}')/to_Plant`;
        const mParams = {
            "$filter": `Plant eq '${plant}'`
        };

        console.log(` Fetching COO for Material ${material}, Plant ${plant}`);

        oModel.read(sPath, {
            urlParameters: mParams,
            success: (oData) => {
                const result = oData?.results?.[0];

                if (result?.CountryOfOrigin) {
                    resolve(result.CountryOfOrigin);
                } else {
                    resolve(""); // Not maintained
                }
            },
            error: (err) => {
                console.error("COO fetch failed", err);
                reject(err);
            }
        });
    });
},

_applyAutoCO: function (countryCode) {
    const oVM = this.getView().getModel("view");

    if (!countryCode) {
        console.warn("⚠️ No Country of Origin found in product");
        return;
    }

    console.log("✅ Auto Country of Origin:", countryCode);

    // Set value
    oVM.setProperty("/rfExtras/CO", countryCode.toUpperCase());

    // Mark as valid (your onCOChange will still re-validate on edit)
    oVM.setProperty("/rfExtras/COValid", true);
},

_getLatestHUs: function (huList) {
    if (!huList.length) return [];

    // Sort by HU creation time DESC
    const sorted = huList.sort((a, b) => {
        const aTime = new Date(a.CreationDateTime || a.CreatedAt || 0).getTime();
        const bTime = new Date(b.CreationDateTime || b.CreatedAt || 0).getTime();
        return bTime - aTime;
    });

    // Take HUs with SAME timestamp as the latest one
    const latestTime = new Date(
        sorted[0].CreationDateTime || sorted[0].CreatedAt
    ).getTime();

    return sorted.filter(hu => {
        const huTime = new Date(
            hu.CreationDateTime || hu.CreatedAt
        ).getTime();
        return huTime === latestTime;
    });
},

_fetchHUsForMaterialDoc: async function (materialDoc) {
    const oModel = this.getView().getModel("huService"); // OData V4
    const oVM = this.getView().getModel("view");

    try {
        const warehouse = oVM.getProperty("/Warehouse");

        const sPath = "/HandlingUnit";

        const mParameters = {
            $filter: `HandlingUnitReferenceDocument eq '${materialDoc}' and Warehouse eq '${warehouse}'`,
            $expand: {
                _HandlingUnitItem: {}
            },
            $$groupId: "$direct"
        };

        console.log("HU LIST PARAMS →", mParameters);

        const oListBinding = oModel.bindList(
            sPath,
            null,
            null,
            null,
            mParameters
        );

        const aContexts = await oListBinding.requestContexts();

        if (!aContexts.length) {
            throw new Error("No Handling Units found for Material Document");
        }

        const aHUs = aContexts.map(c => c.getObject());

        console.log(`${aHUs.length} HUs fetched`, aHUs);

        oVM.setProperty("/huList", aHUs);

        return aHUs;

    } catch (err) {
        console.error("HU Fetch Failed:", err);
        throw err;
    }
},
_fetchHUsForInboundDelivery: async function (ibd) {
    const oModel = this.getView().getModel("huService");
    const warehouse = "PU01";

    if (!oModel) {
        throw new Error("HU service model not found");
    }

    const sPath = "/HandlingUnit";

    console.log("HU LIST BASE PATH →", sPath);

    const oBinding = oModel.bindList(sPath, null, null, null, {
        $filter: `HandlingUnitReferenceDocument eq '${ibd}' and Warehouse eq '${warehouse}'`,
        $expand: {
            _HandlingUnitItem: {}   
        }
    });

    const aContexts = await oBinding.requestContexts(0, 200);
    const aHUs = aContexts.map(ctx => ctx.getObject());

    console.log(`✅ ${aHUs.length} HU HEADERS fetched with ITEMS`);

    return aHUs;
},

_filterHUsByLatestGR: function (huList, matDoc) {
    if (!matDoc?.DocumentNo) {
        console.warn("Material Document number missing — returning all HUs");
        return huList;
    }

    const latestMatDoc = String(matDoc.DocumentNo);

    console.log("Filtering HUs by Material Document:", latestMatDoc);

    const filtered = huList.filter(hu =>
        String(hu.HandlingUnitReferenceDocument) === latestMatDoc
    );

    console.log(`${filtered.length} HUs linked to GR ${latestMatDoc}`);

    return filtered;
},

_extractHUsForMaterialDoc: function (docFlow, matDocNo, matDocYear) {
    if (!Array.isArray(docFlow)) return [];

    return docFlow
        .filter(e =>
            e.SubsequentDocumentCategory === "H" &&   // HU
            e.PrecedingDocument === matDocNo &&
            String(e.PrecedingDocumentYear) === String(matDocYear)
        )
        .map(e => e.SubsequentDocument);
},
// _startHuFlow: async function (sHu) {
//     const oVM = this.getView().getModel("view");

//     try {
//         sap.ui.core.BusyIndicator.show(0);
//         console.log("Starting HU → IBD → PO → DocFlow → MatDoc pipeline");

//         // --------------------------
//         // 1 FETCH HU DETAILS
//         // --------------------------
//         const hu = await this._fetchHUDetails(sHu);
//         if (!hu) throw new Error("HU fetch failed. Stopping pipeline.");

//         console.log("HU OK →", hu);
//         oVM.setProperty("/huDetails", hu);

//         // Extract IBD number from HU
//         const ibd = hu.HandlingUnitReferenceDocument;
//         if (!ibd) throw new Error("IBD missing inside HU response");

//         console.log("IBD extracted:", ibd);
//         oVM.setProperty("/ibd", ibd); // raw number (if you want it)

//         // --------------------------
//         // 2️ FETCH INBOUND DELIVERY ITEMS
//         // --------------------------
//         const ibdItems = await this._fetchInboundDelivery(ibd);
//         if (!ibdItems || ibdItems.length === 0) {
//             throw new Error("No Inbound Delivery Items returned.");
//         }

//         console.log("IBD Items OK →", ibdItems);
//         oVM.setProperty("/ibdItems", ibdItems);

//         // take first item for payload usage
//         const firstItem = ibdItems[0];
//         oVM.setProperty("/ibdDetails", firstItem);   // ⬅ this is what onPrintProgram expects

//         // --------------------------
//         // 3️ FETCH PO USING IBD → ReferenceSDDocument
//         // --------------------------
//       const isProdOrder = firstItem.DeliveryDocumentItemCategory === "DIGN";
// oVM.setProperty("/isProdOrder", isProdOrder);

// if (isProdOrder) {
//     // Production Order — NO API CALL
//     const prodDetails = {
//         OrderID: firstItem.OrderID,
//         OrderItem: firstItem.OrderItem
//     };

//     console.log("Production Order detected →", prodDetails);
//     oVM.setProperty("/prodOrderDetails", prodDetails);

// } else {
//     // Purchase Order — EXISTING FLOW
//     const poNumber = firstItem.ReferenceSDDocument;

//     if (poNumber) {
//         console.log("Fetching PO:", poNumber);

//         const poDetails = await this._fetchPO(poNumber);
//         oVM.setProperty("/poDetails", poDetails);

//     } else {
//         console.warn("No PO found in IBD Item");
//     }
// }

//         // --------------------------
//         // 4️ FETCH DOCUMENT FLOW
//         // --------------------------
//         console.log(`Calling DocFlow for IBD=${ibd}, Item=${firstItem.DeliveryDocumentItem}`);

//         const docFlow = await this._fetchDocumentFlow(
//             ibd,
//             firstItem.DeliveryDocumentItem
//         );

//         if (!docFlow) {
//             throw new Error("Document Flow is empty");
//         }

//         console.log("DOC FLOW ENTRY →", docFlow);
//         oVM.setProperty("/docFlow", docFlow);

//         // --------------------------
//         // 5️ EXTRACT MATERIAL DOCUMENT FROM DOC FLOW
//         // --------------------------
//         const matDocInfo = this._extractMaterialDocument(docFlow);

//         if (!matDocInfo) {
//             console.warn("No Material Document found in Document Flow");
//             oVM.setProperty("/matDoc", null);
//         } else {
//             console.log("Material Doc Keys:", matDocInfo);

//             // --------------------------
//             // 6️ FETCH MATERIAL DOCUMENT ITEM
//             // --------------------------


            
//             const matDocItem = await this._fetchMaterialDocumentItem(
//                 matDocInfo.MaterialDocument,
//                 matDocInfo.Year,
//                 matDocInfo.MaterialDocumentItem
//             );

//             console.log("MATERIAL DOCUMENT ITEM OK:", matDocItem);
//             oVM.setProperty("/matDoc", matDocItem);
//         }


//         // --------------------------
// // 7️ FETCH PRINTER / LAYOUT
// // --------------------------
// // const plant = ibd.Plant;
// // const sloc = ibd.StorageLocation;

// // const printerCfg = await this._fetchPrinterLayout(plant, sloc);

// // oVM.setProperty("/rfExtras/P1", printerCfg.Layout);
// // oVM.setProperty("/rfExtras/F1", printerCfg.Printer);

// // console.log("Printer/Layout resolved →", printerCfg);

//         sap.m.MessageToast.show("All data loaded successfully!");

//     } catch (err) {
//         console.error("Pipeline Error →", err);
//         sap.m.MessageBox.error(err.message);

//     } finally {
//         sap.ui.core.BusyIndicator.hide();
//     }
// },   //---------------------------------------------------------------------
        // HU READ (V4)
        //---------------------------------------------------------------------
 _fetchHUDetails: async function (sHu) {
    const oVM = this.getView().getModel("view");

    try {
        const oModel = this.getView().getModel("huService");

        const warehouse = "PU01";

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
_extractMaterialDocument: function (docFlowArray) {
    if (!Array.isArray(docFlowArray) || docFlowArray.length === 0) {
        return null;
    }

    // 1️ Keep ONLY Goods Receipts
    const grEntries = docFlowArray.filter(
        e => e.SubsequentDocumentCategory === "R"
    );

    if (!grEntries.length) {
        console.warn("No GR entries found in document flow");
        return null;
    }

    // 2️ Pick MAX Material Document NUMERICALLY
    const latest = grEntries.reduce((max, curr) => {
        return Number(curr.SubsequentDocument) > Number(max.SubsequentDocument)
            ? curr
            : max;
    });

    console.log("Latest GR selected:", latest.SubsequentDocument);

    return {
        MaterialDocument: latest.SubsequentDocument,
        MaterialDocumentItem: (latest.SubsequentDocumentItem || "000001").slice(-4),
        Year: new Date().getFullYear().toString() // year comes from header anyway
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
    // 1️ Fetch HEADER (CreationDate)
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
    // 2️ Fetch ITEM (QuantityInBaseUnit)
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

_fetchPrinterLayout: function (plant, sloc) {
    const oModel = this.getOwnerComponent().getModel("printerLayout");

    if (!oModel) {
        console.error("Printer Layout model not found");
        return Promise.reject("Printer Layout model missing");
    }

    const sPath = "/YY1_DEF_PRINTER_LAYOUT";
    const mParams = {
        "$filter": `Plant eq '${plant}' and Sloc eq '${sloc}'`
    };

    console.log("Printer/Layout PATH →", sPath, mParams);

    return new Promise((resolve, reject) => {
        oModel.read(sPath, {
            urlParameters: mParams,
            success: function (oData) {
                if (!oData.results || oData.results.length === 0) {
                    reject("No printer/layout config found");
                } else {
                    resolve(oData.results[0]); // first match
                }
            },
            error: function (oError) {
                console.error("Printer Layout CDS error", oError);
                reject(oError);
            }
        });
    });
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
    const oVM = this.getView().getModel("view");
    const data = oVM.getData();

    try {
        // --------------------------------------------------
        // 1️ HARD VALIDATIONS
        // --------------------------------------------------
        if (!data.ibdDetails) {
            return sap.m.MessageBox.error("Inbound Delivery not loaded");
        }

        if (!data.matDoc?.DocumentNo) {
            return sap.m.MessageBox.error("Latest Goods Receipt not found");
        }

        if (!Array.isArray(data.huList) || data.huList.length === 0) {
            return sap.m.MessageBox.error(
                "No Handling Units found for latest Goods Receipt"
            );
        }

        if (!data.rfExtras.CO || data.rfExtras.COValid !== true) {
            return sap.m.MessageBox.error("Enter valid Country of Origin");
        }

        if (!data.rfExtras.VLot) {
            return sap.m.MessageBox.error("Enter EI#");
        }

        sap.ui.core.BusyIndicator.show(0);

        const ibd = data.ibdDetails;
        const mat = data.matDoc;

        const isProdOrder = data.isProdOrder === true;
        const po = isProdOrder ? null : data.poDetails?.purchaseOrder;
        const poItem = isProdOrder ? null : data.poDetails?.firstItem;
        const prod = isProdOrder ? data.prodOrderDetails : null;

        const sBaseUrl = sap.ui.require.toUrl("inboundlabel");
        const sCpiUrl = sBaseUrl + "/http/Bartender/Order";

        console.log(
            `Printing ${data.huList.length} HU(s) for GR ${mat.DocumentNo}`
        );

        // --------------------------------------------------
        // 2️ PRINT ONLY LATEST HU(s)
        // --------------------------------------------------
        const totalHUs = data.huList.length;

      for (let i = 0; i < totalHUs; i++) {
       const hu = data.huList[i];

            const huItem = hu._HandlingUnitItem?.[0] || {};

            const payload = {
                Order_HU: {
                    // HU
                    HU: hu.HandlingUnitExternalID,
                    barcode: hu.HandlingUnitExternalID,
                    Pack_Material: hu.PackagingMaterial || "",
                    Product: ibd.Material || "",
                    Prod_Desc: ibd.DeliveryDocumentItemText || "",

                    Hu_Quantity: huItem.HandlingUnitQuantity || "",
                    Uom: huItem.HandlingUnitAltUnitOfMeasure || "",
                    St_Type: hu.StorageType || "",
                    Storage_Location: ibd.StorageLocation || "",
                    Storage_Bin: hu.StorageBin || "",

                    // IBD
                    Delivery: ibd.DeliveryDocument,
                    Delivery_Item: ibd.DeliveryDocumentItem,
                    Batch: ibd.Batch || "",

                    // PO / PROD
                    Purchase_Order: isProdOrder ? "" : po?.PurchaseOrder || "",
                    PO_Item:        isProdOrder ? "" : poItem?.PurchaseOrderItem || "",
                    Vendor_Code:    isProdOrder ? "" : po?.Supplier || "",
                    Prod_Order:     isProdOrder ? prod?.OrderID || "" : "",
                    Int_Serialno:   "",

                    // GR
                    GR: mat.DocumentNo,
                    GR_Qty: mat.QuantityInBaseUnit,
                    GR_Date: mat.CreationDate,

                    // UI
                    CO: data.rfExtras.CO,
                    IE: data.rfExtras.VLot,
                    Label_Format: data.rfExtras.P1,
                    Printer: data.rfExtras.F1,
                    Plant: ibd.Plant || "",
    
                     // ---- Vendor / Manufacturer ----
            Vendor_Part: isProdOrder ? "" : poItem?.ManufacturerMaterial || "",
            

            // ---- Dates ----
            Manufacture_date: ibd.ManufactureDate || "",
            Exp_date: ibd.ShelfLifeExpirationDate || "",

            // ---- Stock Indicators ----
            Stock_Category:
                isProdOrder ? "" :
                ibd.StockType === "X" ? "X" : "",

            Special_stock:
                isProdOrder ? "" :
                ibd.SpecialStockType || "",
                Box : `${i + 1} of ${totalHUs}`
                }
            };

            console.log("CPI PAYLOAD in OnPrint →", payload);

            const resp = await fetch(sCpiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (!resp.ok) {
                const err = await resp.text();
                throw new Error(
                    `CPI failed for HU ${hu.HandlingUnitExternalID}: ${err}`
                );
            }

            // Optional persistence (non-blocking)
            // try {
            //     await this._postToHULabelService(payload);
            // } catch (e) {
            //     console.warn(
            //         `HU ${hu.HandlingUnitExternalID} saved partially`,
            //         e.message
            //     );
            // }
        }

        // --------------------------------------------------
        // 3️ SUCCESS
        // --------------------------------------------------
        sap.m.MessageBox.success(
            `HU Labels printed successfully`,
            {
                title: "Print Successful",
                onClose: () => this.onChangeData()
            }
        );

    } catch (err) {
        console.error("Print Flow Error:", err);
        sap.m.MessageBox.error(err.message);
    } finally {
        sap.ui.core.BusyIndicator.hide();
    }
},

//  _postToHULabelService: function (payload) {
//             return new Promise((resolve, reject) => {
//                 const oModel = this.getView().getModel("YY1_hu_label_cds");

//                 if (!oModel) {
//                     console.error("YY1_hu_label_cds model not found");
//                     return reject(new Error("HU Label service model not configured in manifest"));
//                 }

//                 // UPDATE THIS with your actual entity set name from metadata
//                 const sEntitySet = "/YY1_HU_LABEL";

                
//                 // Map payload to OData structure
//                 const odataPayload = this._mapPayloadToOData(payload);

//                 console.log("Posting to OData:", sEntitySet);
//                 console.log("OData Payload:", odataPayload);

//                 oModel.create(sEntitySet, odataPayload, {
//                     success: (oData) => {
//                         console.log(" OData CREATE Success:", oData);
//                         resolve(oData);
//                     },
//                     error: (oError) => {
//                         console.error(" OData CREATE Error:", oError);

//                         // Parse error message
//                         let sErrorMsg = "Failed to save to HU Label service";

//                         if (oError.responseText) {
//                             try {
//                                 const oErrorResponse = JSON.parse(oError.responseText);
//                                 sErrorMsg = oErrorResponse.error?.message?.value ||
//                                     oErrorResponse.error?.innererror?.errordetails?.[0]?.message ||
//                                     sErrorMsg;
//                             } catch (e) {
//                                 sErrorMsg = oError.message || oError.statusText || sErrorMsg;
//                             }
//                         }

//                         console.error("Error details:", sErrorMsg);
//                         reject(new Error(sErrorMsg));
//                     }
//                 });
//             });
//         },

        // ========================================
        // PAYLOAD MAPPING
        //  UPDATE THIS based on your OData metadata
        // ========================================
        _mapPayloadToOData: function (payload) {
            const data = payload.Order_HU;

            // Map CPI structure to OData entity structure
            // These field names are EXAMPLES - update based on YOUR metadata

             const t = (value) => this._truncateString(value, 20);
        const odataPayload = {
    // ========================================
    // KEY FIELD (REQUIRED!)
    // ========================================
    SAP_UUID: this._generateUUID(),

    // ========================================
    // MANDATORY FIELDS (REQUIRED!)
    // ========================================
    GR: t(data.GR || data.GR_No || ""),           // REQUIRED
    HU: t(data.HU || ""),                          // REQUIRED
    Plant: t(data.Plant || ""),                    // REQUIRED

    // ========================================
    // OPTIONAL FIELDS - EXACT METADATA NAMES
    // ========================================
    // Basic HU Info
    barcode: t(data.barcode || data.HU),
    Pack_material: t(data.Pack_Material),          // Note: Pack_material not Pack_Material
    Product: t(data.Product),
    Mat_Desc: t(data.Prod_Desc),
    Batch: t(data.Batch),
    
    // Quantities & UOM
    St_Quantity: t(data.Hu_Quantity),              // Note: St_Quantity for HU quantity
    Quantity: t(data.Hu_Quantity || data.GR_Qty), // Note: Quantity (general)
    Uom: t(data.Uom),                              // Note: Uom NOT UOM!
    
    // Storage Info
    St_Type: t(data.St_Type),                      // Note: St_Type not StorageType
    Storage_Loc: t(data.Storage_Location),         // Note: Storage_Loc not StorageLocation
    Storage_Bin: t(data.Storage_Bin),              // Note: Storage_Bin (correct)
    
    // Dates (ALL are strings, no formatting needed!)
    Exp_Date:t(data.Exp_date),                   // Note: Exp_Date not Exp_date
    Date_Code: t(data.Manufacture_date),          // Note: Date_Code not ManufactureDate
    
    // Purchase Order Info
    Purchase_Ord: t(data.Purchase_Order),          // Note: Purchase_Ord not PurchaseOrder
    Vendor_Code: t(data.Vendor_Code),              // Note: Vendor_Code (correct)
    Stock_Cat: t(data.Stock_Category),             // Note: Stock_Cat not StockCategory
    Spl_Stock: t(data.Special_stock),              // Note: Spl_Stock not SpecialStock
    
    // Production Order Info
    Prod_Ord: t(data.Prod_Order),                  // Note: Prod_Ord not ProductionOrder
    Prod_No: t(data.Prod_Order),                   // Note: Prod_No (production number)
    Int_SerialNo: t(data.Int_Serialno),            // Note: Int_SerialNo not InternalSerialNumber
    
    // Additional Fields
    CO: t(data.CO),
    IE: t(data.IE),
    Label_Format: t(data.Label_Format),            // Note: Label_Format (correct)
    Printer: t(data.Printer),
    Box: t(data.Box),
    
    // Goods Receipt Info
    GR_Qty: t(data.GR_Qty || data.GRQuantity),    // Note: GR_Qty not GRQuantity
    //GR_Date: this._formatDateForSAP(data.GR_Date || data.GRDate),
    GR_Date: t(data.GR_Date || data.GRDate),

     // Note: GR_Date not GRDate
};

            return odataPayload;
        },

        // ========================================
        // HELPER METHODS
        // ========================================
        _formatDate: function (dateValue) {
            if (!dateValue) return null;

            // If already a Date object
            if (dateValue instanceof Date) {
                return dateValue;
            }

            // If string, try to parse
            try {
                const date = new Date(dateValue);
                if (!isNaN(date.getTime())) {
                    return date;
                }
            } catch (e) {
                console.warn("Date parsing failed:", dateValue);
            }

            return null;
        },

        _generateUUID: function () {
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        },

_truncateString: function (value, maxLength) {
    if (!value) return "";
    const str = String(value);
    if (str.length > maxLength) {
        console.warn(`Truncating "${str}" to ${maxLength} chars`);
        return str.substring(0, maxLength);
    }
    return str;
},
_formatDateForSAP: function (dateValue) {
    if (!dateValue) return "";
    
    let date;
    
    try {
        // Handle OData V2 format: /Date(1234567890000)/
        if (typeof dateValue === 'string' && dateValue.startsWith('/Date(')) {
            const timestamp = parseInt(dateValue.match(/\d+/)[0]);
            date = new Date(timestamp);
        }
        // Handle Date object
        else if (dateValue instanceof Date) {
            date = dateValue;
        }
        // Handle string date
        else if (typeof dateValue === 'string') {
            date = new Date(dateValue);
        }
        else {
            return "";
        }
        
        // Validate
        if (isNaN(date.getTime())) return "";
        
        // Format as YYYYMMDD
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        
        return `${year}${month}${day}`;
        
    } catch (error) {
        console.error("Date formatting error:", error);
        return "";
    }
},

 });

    
});