// Generic dynamic collection of figures and tables
// -----------------
//
// Takes care of generating labels and keeping them up to date

var _ = require('substance/util/helpers');
var pluck = require('substance/util/pluck');
var oo = require('substance/util/oo');

function Collection(doc, containerId, itemType, labelPrefix) {
  this.doc = doc;
  this.containerId = containerId;
  this.itemType = itemType;
  this.labelPrefix = labelPrefix;
  this.doc.connect(this, {
    'document:changed': this.onDocumentChanged
  });
}

Collection.Prototype = function() {

  this.dispose = function() {
    this.doc.disconnect(this);
  };

  this.getDocument = function() {
    return this.doc;
  };

  // Determines item order by checking their occurence in the container
  this.determineItems = function() {
    var doc = this.doc;
    var container = doc.get(this.containerId);
    var items = doc.getIndex('type').get(this.itemType);
    // Map itemIds (figures/tables) to container positions
    var _items = [];
    _.each(items, function(item) {
      var pos = container.getPosition(item.id);
      var isShown;
      if (pos >= 0) {
        isShown = true;
      } else {
        isShown = false;
        pos = Number.MAX_VALUE;
      }
      _items.push({
        pos: pos,
        item: item,
        isShown: isShown
      });
    });
    _items = _.sortBy(_items, 'pos');
    var counter = 0;
    _.each(_items, function(_item) {
      if (_item.isShown) {
        _item.index = counter++;
      } else {
        _item.index = -1;
      }
    });
    // console.log('Sorted Items', sortedItems);
    return _items;
  };

  this.createItemLabel = function(_item) {
    if (_item.index < 0) {
      return this.labelPrefix + " ?";
    } else {
      return [this.labelPrefix, _item.index + 1].join(' ');
    }
  };

  this.createCitationLabel = function(_citation) {
    var citation = _citation.citation;
    var targets = citation.targets;
    var targetPositions = [];
    var doc = this.doc;
    var err;
    // find the positions of the cited items
    _.each(targets, function(targetId) {
      var target = doc.get(targetId);
      var itemIndex = this.items.indexOf(target);
      if (itemIndex < 0) {
        console.error("citation target not found: ", targetId);
        err = targetId;
        return;
      }
      var _item = this._items[itemIndex];
      if(_item.index<0) {
        console.error("citation target does not have a label: ", targetId);
        err = targetId;
        return;
      }
      var targetPos = _item.index + 1;
      targetPositions.push(targetPos);
    }.bind(this));
    targetPositions.sort();
    // generate a label by concatenating numbers
    // and provide a special label for empty citations.
    var label;
    if (targetPositions.length === 0) {
      label = this.labelPrefix+ " ???";
    } else {
      label = [this.labelPrefix, targetPositions.join(", ")].join(' ');
    }
    // console.log('generated citation label', label);
    return label;
  };

  this.updateItemLabels = function() {
    _.each(this._items, function(_item) {
      var label = this.createItemLabel(_item);
      // console.log('generated item label', label);
      _item.item.setLabel(label);
    }.bind(this));
  };

  this.updateCitationLabels = function() {
    // console.log('citations', this.citations);
    _.each(this._citations, function(_citation) {
      var label = this.createCitationLabel(_citation);
      _citation.citation.setLabel(label);
    }.bind(this));
  };

  // get citation nodes sorted by occurence in container.
  this.determineCitations = function() {
    var doc = this.doc;
    var citations = doc.getIndex('type').get(this.itemType+'-citation');
    var container = doc.get(this.containerId);
    // generate information for sorting
    var _citations = _.map(citations, function(citation) {
      var address = container.getAddress(citation.path);
      return {
        citation: citation,
        address: address
      };
    });
    // sort citation by occurrence in the container
    _citations.sort(function(a, b) {
      if (a < b) {
        return -1;
      } else if (a > b) {
        return 1;
      } else {
        return a.citation.startOffset - b.citation.startOffset;
      }
    });
    return _citations;
  };

  this.update = function() {
    // items are augmented with information necessary for compilation
    // and are sorted to reflect the order they should appear in the collection
    // ATTENTION: there is a convention here to use `_item` for
    // an augmented item and `item` for the document node.
    this._items = this.determineItems();
    // Note: doing this right away allows us to easily find the
    // position of an item
    this.items = pluck(this._items, 'item');

    this._citations = this.determineCitations();
    this.citations = pluck(this._citations, 'citation');

    // compile labels
    this.updateItemLabels();
    this.updateCitationLabels();
  };

  this.getItems = function() {
    return this.items;
  };

  // HACK: Lots of hard coded things here, we need to improve this along with
  // removing the redudancy with Bibliography.js
  this.onDocumentChanged = function(change) {
    var doc = this.doc;
    var needsUpdate = false;
    var node, deletedNode;

    _.each(change.ops, function(op) {

      // Figure citation has been created/changed/delete
      // -----------------
      //

      if (op.isCreate() || op.isSet() || op.isUpdate()) {
        var nodeId = op.path[0];
        node = doc.get(nodeId);
        if (!node) return;

        if (op.isCreate()) {
          // Create
          if (node.type === 'image-figure-citation' || node.type === 'table-figure-citation') {
            needsUpdate = true;
          }
        } else {
          // Update/Set
          if (node.type === 'image-figure-citation' || node.type === 'table-figure-citation') {
            if (op.path[1] === 'targets') {
              needsUpdate = true;
            }
          }
        }
      } else if (op.isDelete()) {
        // Delete
        deletedNode = op.val;
        if (deletedNode.type === 'image-figure-citation' || deletedNode.type === 'table-figure-citation') {
          needsUpdate = true;
        }
      }


      // New Figure has been inserted/moved or deleted
      // ----------------
      //
      // Figure insert or move case (when container is updated)
      if (!needsUpdate && op.path[0] === this.containerId) {
        if (op.type === "set") {
          needsUpdate = true;
        }
        // Note: updates on the container nodes are always ArrayOperations
        // which have the inserted or removed value as `val`.
        if (op.type === "update") {
          var id = op.diff.val;
          node = doc.get(id);
          // ATTENTION: as these are intermediate ops
          // it may happen that the node itself has been
          // deleted by a later op in this change
          // So this guard can be considered ok
          if (!node) return;
          // look for item type or an include pointing to an item type
          if (node.type === this.itemType) {
            needsUpdate = true;
          }
        }
      }

      // When node of this.itemType has been deleted
      if (op.isDelete()) {
        deletedNode = op.val;
        if (deletedNode.type === this.itemType) {
          needsUpdate = true;
        }
      }
    }.bind(this));

    if (needsUpdate) {
      // console.log('Collection', this.itemType, 'is being updated');
      this.update();
    }
  };

};

oo.initClass(Collection);
module.exports = Collection;