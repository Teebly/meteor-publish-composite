import { Meteor } from 'meteor/meteor';
import { DiffSequence } from 'meteor/diff-sequence';
import { EJSON } from 'meteor/ejson';
import { Match, check } from 'meteor/check';
import { _ } from 'meteor/underscore';

import { debugLog } from './logging';
import PublishedDocumentList from './published_document_list';

// lightly modified from
// https://github.com/meteor/meteor/pull/1494/files#diff-5834447900f60a56d73d9cd6151de804R955
//_diffObjects in now in meteor core
function _makeChangedFields (newDoc, oldDoc) {
  var fields = {};
  DiffSequence.diffObjects(oldDoc, newDoc, {
    leftOnly: function (key, value) {
      fields[key] = undefined;
    },
    rightOnly: function (key, value) {
      fields[key] = value;
    },
    both: function (key, leftValue, rightValue) {
      if (!EJSON.equals(leftValue, rightValue))
        fields[key] = rightValue;
    }
  });
  return fields;
};

function _noop(doc){
    // console.log("--noop", doc);
    return doc
};

class Publication {
    constructor(subscription, options, args) {
        check(options, {
            find: Function,
            children: Match.Optional(Match.OneOf([Object], Function)),
            collectionName: Match.Optional(String),
            projectionFn: Match.Optional(Function),
        });

        this.subscription = subscription;
        this.options = options;
        this.args = args || [];
        this.childrenOptions = options.children || [];
        this.publishedDocs = new PublishedDocumentList();
        this.collectionName = options.collectionName;
        // this.projectionFn = LocalCollection._compileProjection(options.fields || {});
        // console.log(options)
        this.projectionFn = options.projectionFn || _noop;
    }

    publish() {
        this.cursor = this._getCursor();
        if (!this.cursor) { return; }
        const collectionName = this._getCollectionName();
        // Use Meteor.bindEnvironment to make sure the callbacks are run with the same
        // environmentVariables as when publishing the "parent".
        // It's only needed when publish is being recursively run.
        // console.log("*****", projectedNew)
        this.observeHandle = this.cursor.observe({
            added: Meteor.bindEnvironment((doc) => {
                // let kitties = this.subscription.meteorSub.userId;
                const alreadyPublished = this.publishedDocs.has(doc._id);

                if (alreadyPublished) {
                    debugLog('Publication.observeHandle.added', `${collectionName}:${doc._id} already published`);
                    this.publishedDocs.unflagForRemoval(doc._id);
                    this._republishChildrenOf(doc);
                    // this.subscription.changed(collectionName, doc._id, doc);
                    this.subscription.changed(collectionName, doc._id, this.projectionFn(JSON.parse(JSON.stringify(doc))));
                } else {
                    this.publishedDocs.add(collectionName, doc._id);
                    // this.subscription.added(collectionName, doc);
                    let transformedDoc = this.projectionFn(JSON.parse(JSON.stringify(doc)));
                    this._publishChildrenOf(doc);
                    this.subscription.added(collectionName, transformedDoc);
                }
            }),
            changed: Meteor.bindEnvironment((newDoc, oldDoc) => {
                debugLog('Publication.observeHandle.changed', `${collectionName}:${newDoc._id}`);
                let projectedNew = this.projectionFn(JSON.parse(JSON.stringify(newDoc)));
                let projectedOld = this.projectionFn(JSON.parse(JSON.stringify(oldDoc)));
                let changedFields = _makeChangedFields(projectedNew, projectedOld);
                if (!_.isEmpty(changedFields)) {
                    // console.log("=====+", Object.keys(changedFields))
                    // Object.keys(changedFields).forEach(k=>{
                    //     console.log(`Before "${k}" user ${kitties}`, projectedOld[k])
                    //     console.log(`After "${k}" user ${kitties}`, projectedNew[k])
                    // })
                    this.subscription.changed(collectionName, newDoc._id, changedFields);
                }

                this._republishChildrenOf(newDoc);
            }),
            removed: (doc) => {
                debugLog('Publication.observeHandle.removed', `${collectionName}:${doc._id}`);
                this._removeDoc(collectionName, doc._id);
            },
        });
    }

    unpublish() {
        debugLog('Publication.unpublish', this._getCollectionName());
        this._stopObservingCursor();
        this._unpublishAllDocuments();
    }

    _republish() {
        this._stopObservingCursor();

        this.publishedDocs.flagAllForRemoval();

        debugLog('Publication._republish', 'run .publish again');
        this.publish();

        debugLog('Publication._republish', 'unpublish docs from old cursor');
        this._removeFlaggedDocs();
    }

    _getCursor() {
        return this.options.find.apply(this.subscription.meteorSub, this.args);
    }

    _getCollectionName() {
        return this.collectionName || (this.cursor && this.cursor._getCollectionName());
    }

    _publishChildrenOf(doc) {
        const children = _.isFunction(this.childrenOptions) ?
        this.childrenOptions(doc, ...this.args) : this.childrenOptions;
        _.each(children, function createChildPublication(options) {
            const pub = new Publication(this.subscription, options, [doc].concat(this.args));
            this.publishedDocs.addChildPub(doc._id, pub);
            pub.publish();
        }, this);
    }

    _republishChildrenOf(doc) {
        this.publishedDocs.eachChildPub(doc._id, (publication) => {
            publication.args[0] = doc;
            publication._republish();
        });
    }

    _unpublishAllDocuments() {
        this.publishedDocs.eachDocument((doc) => {
            this._removeDoc(doc.collectionName, doc.docId);
        }, this);
    }

    _stopObservingCursor() {
        debugLog('Publication._stopObservingCursor', 'stop observing cursor');

        if (this.observeHandle) {
            this.observeHandle.stop();
            delete this.observeHandle;
        }
    }

    _removeFlaggedDocs() {
        this.publishedDocs.eachDocument((doc) => {
            if (doc.isFlaggedForRemoval()) {
                this._removeDoc(doc.collectionName, doc.docId);
            }
        }, this);
    }

    _removeDoc(collectionName, docId) {
        this.subscription.removed(collectionName, docId);
        this._unpublishChildrenOf(docId);
        this.publishedDocs.remove(docId);
    }

    _unpublishChildrenOf(docId) {
        debugLog('Publication._unpublishChildrenOf', `unpublishing children of ${this._getCollectionName()}:${docId}`);

        this.publishedDocs.eachChildPub(docId, (publication) => {
            publication.unpublish();
        });
    }
}

export default Publication;
