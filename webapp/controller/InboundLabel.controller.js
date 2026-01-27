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
    if (sHu) this._startHuFlow(sHu);
},

onHuChange: function (oEvent) {
    const sHu = oEvent.getParameter("value");
    if (sHu && sHu.length >= 9) this._startHuFlow(sHu);
},

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
      const isProdOrder = firstItem.DeliveryDocumentItemCategory === "DIGN";
oVM.setProperty("/isProdOrder", isProdOrder);

if (isProdOrder) {
    // Production Order — NO API CALL
    const prodDetails = {
        OrderID: firstItem.OrderID,
        OrderItem: firstItem.OrderItem
    };

    console.log("Production Order detected →", prodDetails);
    oVM.setProperty("/prodOrderDetails", prodDetails);

} else {
    // Purchase Order — EXISTING FLOW
    const poNumber = firstItem.ReferenceSDDocument;

    if (poNumber) {
        console.log("Fetching PO:", poNumber);

        const poDetails = await this._fetchPO(poNumber);
        oVM.setProperty("/poDetails", poDetails);

    } else {
        console.warn("No PO found in IBD Item");
    }
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


        // --------------------------
// 7️⃣ FETCH PRINTER / LAYOUT
// --------------------------
// const plant = ibd.Plant;
// const sloc = ibd.StorageLocation;

// const printerCfg = await this._fetchPrinterLayout(plant, sloc);

// oVM.setProperty("/rfExtras/P1", printerCfg.Layout);
// oVM.setProperty("/rfExtras/F1", printerCfg.Printer);

// console.log("Printer/Layout resolved →", printerCfg);

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
    try {
        const oVM = this.getView().getModel("view");
        const data = oVM.getData();

        // -----------------------------
        // 1. VALIDATIONS
        // -----------------------------
        if (!data.HuData) return sap.m.MessageBox.error("Enter Handling Unit");
        if (!data.Warehouse) return sap.m.MessageBox.error("Enter Warehouse");
        if (!data.rfExtras.VLot) return sap.m.MessageBox.error("Enter EI#");
        if (!data.rfExtras.CO) {
    return sap.m.MessageBox.error("Enter Country of Origin");
}

if (data.rfExtras.COValid !== true) {
    return sap.m.MessageBox.error(
        "Invalid Country of Origin. Enter a valid 2-letter country code."
    );
}
        if (!data.huDetails) return sap.m.MessageBox.error("HU details missing — fetch HU first.");
        if (!data.ibdDetails) return sap.m.MessageBox.error("Inbound Delivery missing");
        //if (!data.poDetails) return sap.m.MessageBox.error("PO details missing");
        if (!data.docFlow) return sap.m.MessageBox.error("Document Flow missing");
        if (!data.matDoc) return sap.m.MessageBox.error("Material Document missing");

        sap.ui.core.BusyIndicator.show(0);

        const hu = data.huDetails;
        const ibd = data.ibdDetails;
       const isProdOrder = data.isProdOrder === true;

const po = isProdOrder ? null : data.poDetails?.purchaseOrder;
const poItem = isProdOrder ? null : data.poDetails?.firstItem;
const prod = isProdOrder ? data.prodOrderDetails : null;
        const mat = data.matDoc;

        const huItem = hu._HandlingUnitItem?.[0] || {};

        // -----------------------------
        // 2. BUILD PAYLOAD
        // -----------------------------
    const payload = {
    Order_HU: {
        HU: data.HuData,
        barcode: data.HuData,
        

        // HU
        Pack_Material: hu.PackagingMaterial || "",
        Product: huItem.Material || "",
        Prod_Desc: isProdOrder
            ? huItem.MaterialDescription || ""
            : poItem?.PurchaseOrderItemText || "",

        Hu_Quantity: huItem.HandlingUnitQuantity || "",
        Uom: huItem.HandlingUnitQuantityUnit || "",
        St_Type: hu.StorageType || "",
        Storage_Location: hu.StorageLocation || "",
        Storage_Bin: hu.StorageBin || "",

        // IBD
        Delivery: ibd.DeliveryDocument || "",
        Delivery_Item: ibd.DeliveryDocumentItem || "",
        Exp_date: ibd.ShelfLifeExpirationDate || "",
        Manufacture_date: ibd.ManufactureDate || "",
        Batch: ibd.Batch || "",

        // ----------------------------
        // PURCHASE ORDER (ONLY IF PO)
        // ----------------------------
        Purchase_Order: isProdOrder ? "" : po?.PurchaseOrder || "",
        PO_Item:        isProdOrder ? "" : poItem?.PurchaseOrderItem || "",
        Vendor_Part:    isProdOrder ? "" : poItem?.ManufacturerMaterial || "",
        Vendor_Code:    isProdOrder ? "" : po?.Supplier || "",

        Stock_Category: isProdOrder ? "" :
            poItem?.StockType === "X" ? "X" : "",

        Special_stock: isProdOrder ? "" :
            poItem?.PurchaseOrderCategory === "K" ? "K" : "",

        // ----------------------------
        // PRODUCTION ORDER (TEMP)
        // ----------------------------
        Prod_Order: isProdOrder ? prod?.OrderID || "" : "",
        Int_Serialno: "",

        // GR
        GR: mat.DocumentNo || "",
        GR_Qty: mat.QuantityInBaseUnit || "",
        GR_Date: mat.CreationDate || "",

        // UI
        CO: data.rfExtras.CO,
        IE: data.rfExtras.VLot,
        Label_Format: data.rfExtras.P1,
        Printer: data.rfExtras.F1,
        Box: data.rfExtras.Box || "",
        Plant : ibd.Plant,
        
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

                   try {
                     await this._postToHULabelService(payload);
                    console.log("✅ OData POST Successful");
                } catch (odataError) {
                    // Log but don't fail entire process
                    console.warn("⚠️ OData POST Failed (non-critical):", odataError.message);
                    // Optionally: sap.m.MessageToast.show("Label printed but data save partially failed");
                }


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

 _postToHULabelService: function (payload) {
            return new Promise((resolve, reject) => {
                const oModel = this.getView().getModel("YY1_hu_label_cds");

                if (!oModel) {
                    console.error("❌ YY1_hu_label_cds model not found");
                    return reject(new Error("HU Label service model not configured in manifest"));
                }

                // ⚠️ UPDATE THIS with your actual entity set name from metadata
                const sEntitySet = "/YY1_HU_LABEL";

                
                // Map payload to OData structure
                const odataPayload = this._mapPayloadToOData(payload);

                console.log("📤 Posting to OData:", sEntitySet);
                console.log("📄 OData Payload:", odataPayload);

                oModel.create(sEntitySet, odataPayload, {
                    success: (oData) => {
                        console.log("✅ OData CREATE Success:", oData);
                        resolve(oData);
                    },
                    error: (oError) => {
                        console.error("❌ OData CREATE Error:", oError);

                        // Parse error message
                        let sErrorMsg = "Failed to save to HU Label service";

                        if (oError.responseText) {
                            try {
                                const oErrorResponse = JSON.parse(oError.responseText);
                                sErrorMsg = oErrorResponse.error?.message?.value ||
                                    oErrorResponse.error?.innererror?.errordetails?.[0]?.message ||
                                    sErrorMsg;
                            } catch (e) {
                                sErrorMsg = oError.message || oError.statusText || sErrorMsg;
                            }
                        }

                        console.error("Error details:", sErrorMsg);
                        reject(new Error(sErrorMsg));
                    }
                });
            });
        },

        // ========================================
        // PAYLOAD MAPPING
        // ⚠️ UPDATE THIS based on your OData metadata
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
    GR: t(data.GR || data.GR_No || ""),           // ⚠️ REQUIRED
    HU: t(data.HU || ""),                          // ⚠️ REQUIRED
    Plant: t(data.Plant || ""),                    // ⚠️ REQUIRED

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
        console.warn(`⚠️ Truncating "${str}" to ${maxLength} chars`);
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