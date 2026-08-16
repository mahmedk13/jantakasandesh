const mongoose = require('mongoose');

const authorSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    slug: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    photo: {
        type: String,
        default: ''
    },
    description: {
        type: String,
        default: ''
    },
    isFeatured: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

authorSchema.index({ name: 1 });
authorSchema.index({ slug: 1 });

module.exports = mongoose.model('Author', authorSchema);
